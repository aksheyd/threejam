#ifndef COMPONENT_H
#define COMPONENT_H

#include <iostream>

class Component
{
public:
	unsigned int ID;

	Component() : ID(0) {}

	Component(unsigned int input) {
		ID = input;
		std::cout << "Created component with ID: " << ID << std::endl;
	}
};

#endif
