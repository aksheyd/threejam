#ifndef GAME_OBJECT
#define GAME_OBJECT

#include <vector>
//#include <glm/glm.hpp>
//#include <glm/gtc/matrix_transform.hpp>
//#include <glm/gtc/type_ptr.hpp>
#include "Component.h"

class GameObject
{
public:
	std::vector<Component> components = std::vector<Component>(4);
	//glm::vec3 Transform = glm::vec3(0.0f, 0.0f, 0.0f);

	GameObject() {
		components[0] = Component(1);
	}
};

#endif