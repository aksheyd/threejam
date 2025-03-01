#ifndef MESHRENDERER_H
#define MESHRENDERER_H

#include <iostream>
#include <glm/glm.hpp>
#include <glm/gtc/matrix_transform.hpp>
#include <glm/gtc/type_ptr.hpp>
#include <string>

#include "MeshFilter.h"
#include "Renderer.h"
#include "Camera.h"

class MeshRenderer : public Renderer
{
public:
	glm::vec4 color;

	// pink if color is uninit
	MeshRenderer() : color(1.0f, 0.4f, 0.8f, 1.0f), Renderer("MeshRenderer") {
		_shader.use();
	}

	MeshRenderer(glm::vec4& _color) : color(_color), Renderer("MeshRenderer") {
		_shader.use();
	}

    #include <glm/gtc/matrix_transform.hpp> // Ensure this include is present

    // ...

    void Update() {
        // MeshRenderer controls rendering of MeshFiler
        MeshFilter* meshFilter = gameObject->GetComponent<MeshFilter>();

        if (meshFilter == nullptr) {
            return; // no meshFilter to render
        }

        transform->position.x = sin(glfwGetTime());

        glm::mat4 projection = glm::perspective(glm::radians(Camera::main->Zoom), (float)SCR_WIDTH / (float)SCR_HEIGHT, 0.1f, 100.0f);
        _shader.setMat4("projection", projection);

        glm::mat4 view = Camera::main->GetViewMatrix();
        _shader.setMat4("view", view);

        // set model matrix for camera
        glm::mat4 model = glm::translate(glm::mat4(1.0f), transform->position);
        _shader.setMat4("model", model);

        // set color
        _shader.setVec4("color", color);
        _shader.use();

        //std::cout << meshFilter->mesh.name << std::cout;
        meshFilter->mesh->Draw();
    }
};

#endif